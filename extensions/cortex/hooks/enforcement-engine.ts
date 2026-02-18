/**
 * Enforcement Engine for Pre-Action Hooks
 *
 * Handles enforcement decisions, knowledge injection formatting, and cooldown management.
 * Supports configurable enforcement levels and emergency bypass mechanisms.
 */

import type { KnowledgeContext, KnowledgeResult } from "./knowledge-discovery.js";

export enum EnforcementLevel {
  DISABLED = "disabled",
  ADVISORY = "advisory",
  CATEGORY = "category",
  STRICT = "strict",
}

export interface EnforcementConfig {
  level: EnforcementLevel;
  categoryRules: Map<string, EnforcementLevel>;
  cooldownMs: number;
  confidenceThresholds: Map<string, number>;
  emergencyBypass: boolean;
  maxKnowledgeLength: number;
}

export interface EnforcementDecision {
  block: boolean;
  reason?: string;
  metadata: {
    sopCount: number;
    memoryCount: number;
    confidenceRange: [number, number];
    categories: string[];
    lookupTimeMs: number;
    canBypass: boolean;
    cooldownActive: boolean;
  };
}

export class EnforcementEngine {
  private recentInjections = new Map<string, number>();
  private bypassTokens = new Set<string>();

  constructor(private logger?: any) {}

  /**
   * Decide whether to block tool execution based on knowledge and configuration
   */
  async shouldBlock(
    context: KnowledgeContext,
    knowledge: KnowledgeResult,
    config: EnforcementConfig,
  ): Promise<EnforcementDecision> {
    const metadata = this.buildMetadata(context, knowledge, config);

    // Check if enforcement is disabled globally
    if (config.level === EnforcementLevel.DISABLED) {
      return {
        block: false,
        metadata,
      };
    }

    // Check emergency bypass
    if (config.emergencyBypass) {
      this.logger?.info?.("Emergency bypass active - allowing all tool calls");
      return {
        block: false,
        metadata: { ...metadata, canBypass: true },
      };
    }

    // Check cooldown - if recently injected, don't block again
    const cooldownKey = this.generateCooldownKey(context, knowledge);
    if (this.checkCooldown(cooldownKey, config.cooldownMs)) {
      metadata.cooldownActive = true;
      return {
        block: false,
        metadata,
      };
    }

    // No knowledge found - no need to block
    if (knowledge.totalSources === 0) {
      return {
        block: false,
        metadata,
      };
    }

    // Determine enforcement level for this context
    const effectiveLevel = this.determineEffectiveLevel(context, knowledge, config);

    switch (effectiveLevel) {
      case EnforcementLevel.DISABLED:
        return { block: false, metadata };

      case EnforcementLevel.ADVISORY:
        // Advisory mode: show knowledge but don't block
        return {
          block: false,
          reason: await this.formatKnowledgeInjection(context, knowledge, config, "advisory"),
          metadata,
        };

      case EnforcementLevel.CATEGORY:
      case EnforcementLevel.STRICT:
        // Block execution and require acknowledgment
        await this.trackInjection(cooldownKey);
        return {
          block: true,
          reason: await this.formatKnowledgeInjection(context, knowledge, config, "blocking"),
          metadata,
        };

      default:
        return { block: false, metadata };
    }
  }

  /**
   * Format knowledge injection message for agent consumption
   */
  async formatKnowledgeInjection(
    context: KnowledgeContext,
    knowledge: KnowledgeResult,
    config: EnforcementConfig,
    mode: "advisory" | "blocking" = "blocking",
  ): Promise<string> {
    const parts: string[] = [];

    // Header based on mode
    if (mode === "blocking") {
      parts.push(`🛡️ **PRE-ACTION KNOWLEDGE CONSULTATION REQUIRED**\n`);
      parts.push(`**Tool**: \`${context.toolName}\``);
      parts.push(`**Risk Level**: ${context.riskLevel.toUpperCase()}`);
      parts.push(`**Knowledge Sources Found**: ${knowledge.totalSources}`);
      parts.push("");
    } else {
      parts.push(`💡 **Knowledge Available for \`${context.toolName}\`**\n`);
    }

    // SOP sections
    if (knowledge.sopFiles.length > 0) {
      parts.push("## 📋 Standard Operating Procedures\n");

      for (const sop of knowledge.sopFiles.slice(0, 3)) {
        // Limit to top 3 SOPs
        parts.push(`### ${sop.label}`);
        parts.push(`**Pattern**: \`${sop.matchedPattern}\``);
        parts.push(`**Sections**: ${sop.sections.join(", ")}\n`);

        if (sop.content && sop.content.length > 0) {
          const truncated =
            sop.content.length > 1000
              ? sop.content.substring(0, 1000) + "\n\n[... truncated ...]"
              : sop.content;
          parts.push("```markdown");
          parts.push(truncated);
          parts.push("```\n");
        }
      }

      if (knowledge.sopFiles.length > 3) {
        parts.push(`*... and ${knowledge.sopFiles.length - 3} more SOPs*\n`);
      }
    }

    // Memory sections
    if (knowledge.memories.length > 0) {
      parts.push("## 🧠 Relevant Cortex Memories\n");

      // Group memories by category for better organization
      const memoriesByCategory = this.groupMemoriesByCategory(knowledge.memories);

      for (const [category, memories] of memoriesByCategory.entries()) {
        if (memories.length === 0) continue;

        parts.push(`### ${category.toUpperCase()} (${memories.length} memories)`);

        // Show top memories by confidence
        const topMemories = memories.sort((a, b) => b.confidence - a.confidence).slice(0, 5); // Limit to top 5 per category

        for (const memory of topMemories) {
          const confidenceBar = this.formatConfidenceBar(memory.confidence);
          const truncatedContent =
            memory.content.length > 200 ? memory.content.substring(0, 200) + "..." : memory.content;

          parts.push(`- **${confidenceBar}** ${truncatedContent}`);
          parts.push(
            `  *Accessed ${memory.accessCount} times, last: ${new Date(memory.lastAccessed).toLocaleDateString()}*`,
          );
        }

        if (memories.length > 5) {
          parts.push(`  *... and ${memories.length - 5} more memories*`);
        }
        parts.push("");
      }
    }

    // Context information
    parts.push("## 🔍 Detected Context\n");
    if (context.projectPath) {
      parts.push(`**Project**: ${context.projectPath}`);
    }
    if (context.serviceType) {
      parts.push(`**Service**: ${context.serviceType}`);
    }
    if (context.hostTarget) {
      parts.push(`**Host**: ${context.hostTarget}`);
    }
    if (context.commandType) {
      parts.push(`**Command**: ${context.commandType}`);
    }
    parts.push(`**Keywords**: ${context.keywords.join(", ")}`);
    parts.push(`**Lookup Time**: ${knowledge.lookupTimeMs}ms`);
    parts.push("");

    // Instructions based on mode
    if (mode === "blocking") {
      parts.push("## ✅ Required Action\n");
      parts.push("**Please review the above knowledge, then retry your tool call to proceed.**");
      parts.push("");
      parts.push("The system will remember your acknowledgment for the next 5 minutes.");

      if (config.emergencyBypass) {
        parts.push("");
        parts.push("*Emergency bypass is available if this is a critical operation.*");
      }
    } else {
      parts.push("## ℹ️ Advisory Notice\n");
      parts.push(
        "This knowledge is provided for your awareness. Your tool call will proceed normally.",
      );
    }

    const message = parts.join("\n");

    // Truncate if too long
    if (message.length > config.maxKnowledgeLength) {
      const truncated = message.substring(0, config.maxKnowledgeLength - 100);
      return truncated + "\n\n[... message truncated for brevity ...]";
    }

    return message;
  }

  /**
   * Track knowledge injection for cooldown management
   */
  async trackInjection(key: string): Promise<void> {
    this.recentInjections.set(key, Date.now());

    // Clean up old entries periodically
    if (this.recentInjections.size > 1000) {
      const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
      for (const [k, timestamp] of this.recentInjections.entries()) {
        if (timestamp < cutoff) {
          this.recentInjections.delete(k);
        }
      }
    }
  }

  /**
   * Check if cooldown is active for a given key
   */
  checkCooldown(key: string, cooldownMs: number): boolean {
    const lastInjection = this.recentInjections.get(key);
    if (!lastInjection) return false;

    const elapsed = Date.now() - lastInjection;
    return elapsed < cooldownMs;
  }

  /**
   * Generate emergency bypass token (for authorized users only)
   */
  generateBypassToken(): string {
    const token = Math.random().toString(36).substring(2, 15);
    this.bypassTokens.add(token);

    // Token expires in 1 hour
    setTimeout(
      () => {
        this.bypassTokens.delete(token);
      },
      60 * 60 * 1000,
    );

    return token;
  }

  /**
   * Validate emergency bypass token
   */
  validateBypassToken(token: string): boolean {
    return this.bypassTokens.has(token);
  }

  // Private helper methods

  private buildMetadata(
    context: KnowledgeContext,
    knowledge: KnowledgeResult,
    config: EnforcementConfig,
  ): EnforcementDecision["metadata"] {
    const confidences = knowledge.memories.map((m) => m.confidence);
    const confidenceRange: [number, number] =
      confidences.length > 0 ? [Math.min(...confidences), Math.max(...confidences)] : [0, 0];

    const categories = [...new Set(knowledge.memories.map((m) => m.category))];

    return {
      sopCount: knowledge.sopFiles.length,
      memoryCount: knowledge.memories.length,
      confidenceRange,
      categories,
      lookupTimeMs: knowledge.lookupTimeMs,
      canBypass: config.emergencyBypass,
      cooldownActive: false,
    };
  }

  private determineEffectiveLevel(
    context: KnowledgeContext,
    knowledge: KnowledgeResult,
    config: EnforcementConfig,
  ): EnforcementLevel {
    // If we're in category mode, check category-specific rules
    if (config.level === EnforcementLevel.CATEGORY) {
      const categories = [...new Set(knowledge.memories.map((m) => m.category))];

      // Find the most restrictive level among all relevant categories
      let maxLevel = EnforcementLevel.ADVISORY;

      for (const category of categories) {
        const categoryLevel = config.categoryRules.get(category) || EnforcementLevel.ADVISORY;
        if (this.getLevelPriority(categoryLevel) > this.getLevelPriority(maxLevel)) {
          maxLevel = categoryLevel;
        }
      }

      // Also consider SOPs as high priority
      if (knowledge.sopFiles.length > 0 && maxLevel === EnforcementLevel.ADVISORY) {
        maxLevel = EnforcementLevel.CATEGORY;
      }

      return maxLevel;
    }

    return config.level;
  }

  private getLevelPriority(level: EnforcementLevel): number {
    switch (level) {
      case EnforcementLevel.DISABLED:
        return 0;
      case EnforcementLevel.ADVISORY:
        return 1;
      case EnforcementLevel.CATEGORY:
        return 2;
      case EnforcementLevel.STRICT:
        return 3;
      default:
        return 1;
    }
  }

  private generateCooldownKey(context: KnowledgeContext, knowledge: KnowledgeResult): string {
    // Create a key based on tool, context, and knowledge sources
    const keyParts = [
      context.toolName,
      context.projectPath || "no-project",
      context.serviceType || "no-service",
      knowledge.sopFiles
        .map((s) => s.label)
        .sort()
        .join(","),
      knowledge.memories
        .map((m) => m.category)
        .sort()
        .join(","),
    ];

    return keyParts.join("|");
  }

  private groupMemoriesByCategory(memories: any[]): Map<string, any[]> {
    const groups = new Map<string, any[]>();

    for (const memory of memories) {
      const category = memory.category || "general";
      if (!groups.has(category)) {
        groups.set(category, []);
      }
      groups.get(category)!.push(memory);
    }

    return groups;
  }

  private formatConfidenceBar(confidence: number): string {
    const percentage = Math.round(confidence * 100);
    const bars = Math.round(confidence * 5);
    const filled = "█".repeat(bars);
    const empty = "░".repeat(5 - bars);
    return `${filled}${empty} ${percentage}%`;
  }
}
