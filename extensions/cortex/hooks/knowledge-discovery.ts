/**
 * Knowledge Discovery Engine for Pre-Action Hooks
 *
 * Provides intelligent context extraction and multi-source knowledge lookup
 * for the pre-action hook system. Integrates SOPs and Cortex memories.
 */

export interface KnowledgeContext {
  toolName: string;
  params: Record<string, unknown>;
  keywords: string[];
  projectPath?: string;
  serviceType?: string;
  hostTarget?: string;
  workingDir?: string;
  urlHost?: string;
  commandType?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface SopResult {
  label: string;
  path: string;
  content: string;
  priority: number;
  matchedPattern: string;
  sections: string[];
}

export interface MemoryResult {
  id: string;
  content: string;
  confidence: number;
  category: string;
  lastAccessed: string;
  accessCount: number;
}

export interface KnowledgeResult {
  sopFiles: SopResult[];
  memories: MemoryResult[];
  totalSources: number;
  lookupTimeMs: number;
  cacheHits: number;
}

export interface LookupOptions {
  confidenceThreshold: number;
  maxLookupMs: number;
  includeCategories: string[];
  enableCaching: boolean;
}

export class KnowledgeDiscovery {
  private sopCache = new Map<string, { content: string; timestamp: number }>();
  private memoryCache = new Map<string, { results: MemoryResult[]; timestamp: number }>();
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(
    private cortexBridge: any,
    private logger?: any,
  ) {}

  /**
   * Extract comprehensive context from tool call parameters
   */
  async extractContext(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<KnowledgeContext> {
    const startTime = Date.now();

    try {
      const context: KnowledgeContext = {
        toolName,
        params,
        keywords: [],
        riskLevel: "medium",
      };

      // Extract keywords based on tool type
      switch (toolName) {
        case "exec":
          context.keywords.push(...this.extractExecKeywords(params));
          context.commandType = this.extractPrimaryCommand(params);
          context.riskLevel = this.assessExecRisk(params);
          break;

        case "nodes":
          context.keywords.push(...this.extractNodesKeywords(params));
          context.hostTarget = this.extractHostTarget(params);
          context.riskLevel = "high"; // Node operations are inherently risky
          break;

        case "browser":
          context.keywords.push(...this.extractBrowserKeywords(params));
          context.urlHost = this.extractUrlHost(params);
          context.riskLevel = "low"; // Browser operations are typically safe
          break;

        case "message":
          context.keywords.push(...this.extractMessageKeywords(params));
          context.riskLevel = "low";
          break;
      }

      // Detect project context
      context.projectPath = this.detectProject(params);
      if (context.projectPath) {
        const projectName = context.projectPath.split("/").pop();
        if (projectName) {
          context.keywords.push(projectName);
        }
      }

      // Detect service type
      context.serviceType = this.detectService(context.keywords);

      // Detect working directory
      context.workingDir = this.extractWorkingDir(params);

      this.logger?.debug?.(
        `Context extraction completed in ${Date.now() - startTime}ms: ${context.keywords.length} keywords`,
      );

      return context;
    } catch (error) {
      this.logger?.error?.(`Context extraction failed: ${error}`);
      // Return minimal context to prevent blocking
      return {
        toolName,
        params,
        keywords: [toolName],
        riskLevel: "medium",
      };
    }
  }

  /**
   * Discover relevant SOPs based on context
   */
  async discoverSOPs(context: KnowledgeContext): Promise<SopResult[]> {
    const sopPatterns = [
      // Project-specific SOPs
      {
        pattern: /\/Projects\/([^\/]+)/,
        sopPaths: (match: RegExpMatchArray) => [`~/Projects/${match[1]}/${match[1]}.ai.sop`],
        label: (match: RegExpMatchArray) => `${match[1]} Project SOP`,
        priority: 10,
        sections: ["preflight", "gotchas", "credentials"],
      },

      // Service-specific SOPs
      {
        pattern: /comfyui|flux|8188/i,
        sopPaths: () => ["~/Projects/helios/extensions/cortex/sop/comfyui.ai.sop"],
        label: () => "ComfyUI Operations SOP",
        priority: 8,
        sections: ["preflight", "credentials", "troubleshooting"],
      },

      // Fleet operations
      {
        pattern: /ssh|\.163|\.179|\.141|fleet/i,
        sopPaths: () => ["~/Projects/helios/extensions/cortex/sop/fleet.ai.sop"],
        label: () => "Fleet Operations SOP",
        priority: 9,
        sections: ["preflight", "security", "credentials"],
      },

      // Docker operations
      {
        pattern: /docker|compose|container/i,
        sopPaths: () => ["~/Projects/helios/extensions/cortex/sop/docker-deploy.ai.sop"],
        label: () => "Docker Deployment SOP",
        priority: 7,
        sections: ["preflight", "gotchas", "rollback"],
      },

      // Git operations
      {
        pattern: /git\s+(push|pull|merge|rebase|reset)/i,
        sopPaths: () => ["~/Projects/helios/extensions/cortex/sop/git.ai.sop"],
        label: () => "Git Operations SOP",
        priority: 6,
        sections: ["preflight", "merge", "rollback"],
      },

      // Database operations
      {
        pattern: /sqlite|postgres|mysql|database/i,
        sopPaths: () => ["~/Projects/helios/extensions/cortex/sop/database.ai.sop"],
        label: () => "Database Operations SOP",
        priority: 8,
        sections: ["backup", "migration", "recovery"],
      },
    ];

    const results: SopResult[] = [];
    const contextString = JSON.stringify(context.params).toLowerCase();

    for (const pattern of sopPatterns) {
      const match = contextString.match(pattern.pattern);
      if (match) {
        const paths = pattern.sopPaths(match);
        for (const path of paths) {
          try {
            const content = await this.loadSOPContent(path);
            if (content) {
              results.push({
                label: pattern.label(match),
                path,
                content: this.extractSOPSections(content, pattern.sections),
                priority: pattern.priority,
                matchedPattern: pattern.pattern.source,
                sections: pattern.sections,
              });
            }
          } catch (error) {
            this.logger?.debug?.(`Failed to load SOP ${path}: ${error}`);
          }
        }
      }
    }

    // Sort by priority (highest first)
    return results.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Discover relevant memories from Cortex
   */
  async discoverMemories(
    context: KnowledgeContext,
    confidenceThreshold: number,
  ): Promise<MemoryResult[]> {
    if (!this.cortexBridge) {
      return [];
    }

    try {
      const cacheKey = `${context.keywords.join(",")}_${confidenceThreshold}`;
      const cached = this.memoryCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.results;
      }

      // Search across relevant categories with keywords
      const categories = ["process", "technical", "security", "gotchas", "credentials"];
      const searchQuery = context.keywords.join(" ");

      const memories =
        (await this.cortexBridge.searchMemoriesWithConfidence?.(
          searchQuery,
          categories,
          confidenceThreshold,
          20, // Limit results
        )) || [];

      const results: MemoryResult[] = memories.map((memory: any) => ({
        id: memory.id || memory._id,
        content: memory.content,
        confidence: memory.confidence || 0.5,
        category: memory.category || "general",
        lastAccessed: memory.last_accessed || new Date().toISOString(),
        accessCount: memory.access_count || 0,
      }));

      // Cache the results
      this.memoryCache.set(cacheKey, {
        results,
        timestamp: Date.now(),
      });

      return results;
    } catch (error) {
      this.logger?.error?.(`Memory discovery failed: ${error}`);
      return [];
    }
  }

  /**
   * Parallel lookup of SOPs and memories with timeout protection
   */
  async parallelLookup(
    context: KnowledgeContext,
    options: LookupOptions,
  ): Promise<KnowledgeResult> {
    const startTime = Date.now();
    let cacheHits = 0;

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Knowledge lookup timeout")), options.maxLookupMs),
    );

    try {
      const [sopResults, memoryResults] = (await Promise.race([
        Promise.all([
          this.discoverSOPs(context),
          this.discoverMemories(context, options.confidenceThreshold),
        ]),
        timeout,
      ])) as [SopResult[], MemoryResult[]];

      const lookupTimeMs = Date.now() - startTime;

      return {
        sopFiles: sopResults,
        memories: memoryResults.filter((m) => options.includeCategories.includes(m.category)),
        totalSources: sopResults.length + memoryResults.length,
        lookupTimeMs,
        cacheHits,
      };
    } catch (error) {
      this.logger?.warn?.(`Knowledge lookup failed, falling back to SOPs only: ${error}`);

      // Fallback to SOP-only lookup
      try {
        const sopResults = await this.discoverSOPs(context);
        return {
          sopFiles: sopResults,
          memories: [],
          totalSources: sopResults.length,
          lookupTimeMs: Date.now() - startTime,
          cacheHits,
        };
      } catch (fallbackError) {
        this.logger?.error?.(`Complete knowledge lookup failure: ${fallbackError}`);
        return {
          sopFiles: [],
          memories: [],
          totalSources: 0,
          lookupTimeMs: Date.now() - startTime,
          cacheHits,
        };
      }
    }
  }

  // Private helper methods

  private extractExecKeywords(params: Record<string, unknown>): string[] {
    const keywords: string[] = [];
    const command = params.command as string;

    if (command) {
      // Extract primary command
      const primaryCmd = command.trim().split(/\s+/)[0];
      keywords.push(primaryCmd);

      // Extract common patterns
      const patterns = [
        /git\s+(\w+)/g,
        /docker\s+(\w+)/g,
        /npm\s+(\w+)/g,
        /yarn\s+(\w+)/g,
        /ssh\s+[\w@]*([^\s]+)/g,
        /cd\s+([^\s]+)/g,
      ];

      for (const pattern of patterns) {
        const matches = command.matchAll(pattern);
        for (const match of matches) {
          if (match[1]) keywords.push(match[1]);
        }
      }
    }

    return keywords;
  }

  private extractNodesKeywords(params: Record<string, unknown>): string[] {
    const keywords = ["nodes"];

    if (params.action) {
      keywords.push(params.action as string);
    }

    if (params.node) {
      keywords.push(params.node as string);
    }

    return keywords;
  }

  private extractBrowserKeywords(params: Record<string, unknown>): string[] {
    const keywords = ["browser"];

    if (params.action) {
      keywords.push(params.action as string);
    }

    if (params.targetUrl) {
      try {
        const url = new URL(params.targetUrl as string);
        keywords.push(url.hostname);
      } catch {}
    }

    return keywords;
  }

  private extractMessageKeywords(params: Record<string, unknown>): string[] {
    const keywords = ["message"];

    if (params.action) {
      keywords.push(params.action as string);
    }

    if (params.channel) {
      keywords.push(params.channel as string);
    }

    return keywords;
  }

  private extractPrimaryCommand(params: Record<string, unknown>): string | undefined {
    const command = params.command as string;
    return command?.trim().split(/\s+/)[0];
  }

  private assessExecRisk(params: Record<string, unknown>): "low" | "medium" | "high" | "critical" {
    const command = params.command as string;

    if (!command) return "low";

    // Critical risk commands
    const criticalPatterns = [/rm\s+-rf/i, /dd\s+if=/i, /mkfs\./i, /fdisk/i];

    // High risk commands
    const highPatterns = [
      /git\s+push\s+--force/i,
      /docker\s+system\s+prune/i,
      /npm\s+publish/i,
      /sudo/i,
    ];

    // Medium risk commands
    const mediumPatterns = [/git\s+(push|pull|merge)/i, /docker\s+(build|run)/i, /ssh/i];

    for (const pattern of criticalPatterns) {
      if (pattern.test(command)) return "critical";
    }

    for (const pattern of highPatterns) {
      if (pattern.test(command)) return "high";
    }

    for (const pattern of mediumPatterns) {
      if (pattern.test(command)) return "medium";
    }

    return "low";
  }

  private detectProject(params: Record<string, unknown>): string | undefined {
    const command = params.command as string;
    const workdir = params.workdir as string;

    const paths = [command, workdir].filter(Boolean);

    for (const path of paths) {
      const match = path.match(/\/Projects\/([^\/\s]+)/);
      if (match) {
        return `/Projects/${match[1]}`;
      }
    }

    return undefined;
  }

  private detectService(keywords: string[]): string | undefined {
    const serviceMap: Record<string, string> = {
      comfyui: "comfyui",
      flux: "comfyui",
      docker: "docker",
      compose: "docker",
      git: "git",
      ssh: "ssh",
      augur: "augur",
      postgres: "database",
      sqlite: "database",
    };

    for (const keyword of keywords) {
      if (serviceMap[keyword.toLowerCase()]) {
        return serviceMap[keyword.toLowerCase()];
      }
    }

    return undefined;
  }

  private extractHostTarget(params: Record<string, unknown>): string | undefined {
    const node = params.node as string;
    if (node) return node;

    // Look for IP patterns in command
    const command = params.command as string;
    if (command) {
      const ipMatch = command.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
      if (ipMatch) return ipMatch[1];
    }

    return undefined;
  }

  private extractUrlHost(params: Record<string, unknown>): string | undefined {
    const targetUrl = params.targetUrl as string;
    if (targetUrl) {
      try {
        return new URL(targetUrl).hostname;
      } catch {}
    }
    return undefined;
  }

  private extractWorkingDir(params: Record<string, unknown>): string | undefined {
    return (params.workdir as string) || (params.cwd as string);
  }

  private async loadSOPContent(path: string): Promise<string | null> {
    try {
      // Check cache first
      const cached = this.sopCache.get(path);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.content;
      }

      // Load from file system (this would need to be implemented via the file system API)
      // For now, return null as we need to integrate with the actual file reading mechanism
      return null;
    } catch (error) {
      this.logger?.debug?.(`Failed to load SOP ${path}: ${error}`);
      return null;
    }
  }

  private extractSOPSections(content: string, sections: string[]): string {
    if (!sections.length) return content;

    const extracted: string[] = [];

    for (const section of sections) {
      const pattern = new RegExp(`^#+\\s*${section}\\s*$`, "im");
      const lines = content.split("\n");
      let inSection = false;
      let sectionContent: string[] = [];

      for (const line of lines) {
        if (pattern.test(line)) {
          if (sectionContent.length > 0) break; // End of previous section
          inSection = true;
          sectionContent.push(line);
          continue;
        }

        if (inSection) {
          if (line.match(/^#+\s/)) {
            // New section started
            break;
          }
          sectionContent.push(line);
        }
      }

      if (sectionContent.length > 0) {
        extracted.push(sectionContent.join("\n"));
      }
    }

    return extracted.join("\n\n");
  }
}
