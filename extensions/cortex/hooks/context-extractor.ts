/**
 * Context Extractor for Pre-Action Hooks
 *
 * Intelligent context extraction from tool call parameters.
 * Extracts project paths, service types, hosts, URLs, and keywords.
 */

export interface ContextPattern {
  pattern: RegExp;
  extractor: (match: RegExpMatchArray, params: Record<string, unknown>) => string[];
  priority: number;
}

export interface ExtractedContext {
  keywords: string[];
  projectPath?: string;
  serviceType?: string;
  hostTarget?: string;
  workingDir?: string;
  urlHost?: string;
  commandType?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}

/** Service detection mapping: keyword → canonical service name */
const SERVICE_MAP: Record<string, string> = {
  comfyui: "comfyui",
  flux: "comfyui",
  "8188": "comfyui",
  docker: "docker",
  compose: "docker",
  container: "docker",
  git: "git",
  ssh: "ssh",
  augur: "augur",
  trading: "augur",
  postgres: "database",
  sqlite: "database",
  mysql: "database",
  octoprint: "3d-printing",
  prusa: "3d-printing",
  wazuh: "security",
  radio: "ham-radio",
  ft991: "ham-radio",
  hamlib: "ham-radio",
};

/** Risk patterns for exec commands */
const RISK_PATTERNS = {
  critical: [/rm\s+-rf/i, /dd\s+if=/i, /mkfs\./i, /fdisk/i, /wipefs/i],
  high: [
    /git\s+push\s+--force/i,
    /docker\s+system\s+prune/i,
    /npm\s+publish/i,
    /sudo/i,
    /systemctl\s+(stop|restart|disable)/i,
  ],
  medium: [
    /git\s+(push|pull|merge|rebase)/i,
    /docker\s+(build|run|stop)/i,
    /ssh/i,
    /pip\s+install/i,
  ],
} as const;

export class ContextExtractor {
  /**
   * Extract full context from a tool call
   */
  extract(toolName: string, params: Record<string, unknown>): ExtractedContext {
    const ctx: ExtractedContext = {
      keywords: [],
      riskLevel: "low",
    };

    switch (toolName) {
      case "exec":
        this.extractExec(params, ctx);
        break;
      case "nodes":
        this.extractNodes(params, ctx);
        break;
      case "browser":
        this.extractBrowser(params, ctx);
        break;
      case "message":
        this.extractMessage(params, ctx);
        break;
      default:
        ctx.keywords.push(toolName);
    }

    // Detect project from any path-like parameter
    ctx.projectPath = this.detectProject(params);
    if (ctx.projectPath) {
      const name = ctx.projectPath.split("/").pop();
      if (name) ctx.keywords.push(name);
    }

    // Detect working directory
    ctx.workingDir = (params.workdir as string) || (params.cwd as string) || undefined;

    // Detect service from accumulated keywords
    ctx.serviceType = this.detectService(ctx.keywords);

    return ctx;
  }

  private extractExec(params: Record<string, unknown>, ctx: ExtractedContext): void {
    const command = (params.command as string) || "";

    // Primary command
    const primary = command.trim().split(/\s+/)[0];
    if (primary) {
      ctx.keywords.push(primary);
      ctx.commandType = primary;
    }

    // Extract sub-commands from known CLIs
    const cliPatterns = [
      /git\s+(\w+)/g,
      /docker\s+(\w+)/g,
      /npm\s+(\w+)/g,
      /pnpm\s+(\w+)/g,
      /yarn\s+(\w+)/g,
      /systemctl\s+(\w+)/g,
      /ssh\s+[\w@]*([^\s]+)/g,
    ];

    for (const p of cliPatterns) {
      for (const m of command.matchAll(p)) {
        if (m[1]) ctx.keywords.push(m[1]);
      }
    }

    // Host detection from SSH targets or IPs
    const ipMatch = command.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    if (ipMatch) ctx.hostTarget = ipMatch[1];

    const hostMatch = command.match(/ssh\s+(?:[\w-]+@)?([a-zA-Z][\w.-]+\.\w+)/);
    if (hostMatch && !ctx.hostTarget) ctx.hostTarget = hostMatch[1];

    // Risk assessment
    ctx.riskLevel = this.assessExecRisk(command);
  }

  private extractNodes(params: Record<string, unknown>, ctx: ExtractedContext): void {
    ctx.keywords.push("nodes");
    if (params.action) ctx.keywords.push(params.action as string);
    if (params.node) {
      ctx.keywords.push(params.node as string);
      ctx.hostTarget = params.node as string;
    }
    ctx.riskLevel = "high"; // Node ops inherently risky
  }

  private extractBrowser(params: Record<string, unknown>, ctx: ExtractedContext): void {
    ctx.keywords.push("browser");
    if (params.action) ctx.keywords.push(params.action as string);
    if (params.targetUrl) {
      try {
        const url = new URL(params.targetUrl as string);
        ctx.urlHost = url.hostname;
        ctx.keywords.push(url.hostname);
      } catch {
        /* ignore bad URLs */
      }
    }
    ctx.riskLevel = "low";
  }

  private extractMessage(params: Record<string, unknown>, ctx: ExtractedContext): void {
    ctx.keywords.push("message");
    if (params.action) ctx.keywords.push(params.action as string);
    if (params.channel) ctx.keywords.push(params.channel as string);
    ctx.riskLevel = "low";
  }

  private detectProject(params: Record<string, unknown>): string | undefined {
    const candidates = [
      params.command as string,
      params.workdir as string,
      params.cwd as string,
      params.file_path as string,
      params.path as string,
    ].filter(Boolean);

    for (const s of candidates) {
      const m = s.match(/\/Projects\/([^\/\s]+)/);
      if (m) return `/Projects/${m[1]}`;
    }
    return undefined;
  }

  private detectService(keywords: string[]): string | undefined {
    for (const kw of keywords) {
      const svc = SERVICE_MAP[kw.toLowerCase()];
      if (svc) return svc;
    }
    return undefined;
  }

  private assessExecRisk(command: string): "low" | "medium" | "high" | "critical" {
    if (!command) return "low";
    for (const p of RISK_PATTERNS.critical) if (p.test(command)) return "critical";
    for (const p of RISK_PATTERNS.high) if (p.test(command)) return "high";
    for (const p of RISK_PATTERNS.medium) if (p.test(command)) return "medium";
    return "low";
  }
}
