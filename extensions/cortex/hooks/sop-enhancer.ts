/**
 * SOP Enhancer for Pre-Action Hooks
 *
 * Extended SOP pattern matching (20+ patterns) with section extraction,
 * caching, and priority-based ordering.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SOPMatch {
  label: string;
  path: string;
  content: string;
  priority: number;
  matchedPattern: string;
  sections: string[];
}

interface SOPPattern {
  pattern: RegExp;
  sopPaths: string[];
  label: string;
  priority: number;
  sections: string[];
}

/**
 * Extract a named section (YAML-style or markdown heading) from SOP content.
 * Returns the section body or empty string if not found.
 */
function extractSection(content: string, sectionName: string): string {
  // Try markdown heading first: ## sectionName or ### sectionName
  const headingRe = new RegExp(`^#{1,4}\\s*${sectionName}\\s*$`, "im");
  const lines = content.split("\n");
  let capturing = false;
  const out: string[] = [];

  for (const line of lines) {
    if (headingRe.test(line)) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if (/^#{1,4}\s/.test(line)) break; // next heading
      out.push(line);
    }
  }
  if (out.length) return out.join("\n").trim();

  // Fallback: YAML-style key block
  const yamlRe = new RegExp(`^${sectionName}:\\s*$`, "im");
  capturing = false;
  const yamlOut: string[] = [];
  for (const line of lines) {
    if (yamlRe.test(line)) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if (/^\S/.test(line) && line.trim() !== "") break; // new top-level key
      yamlOut.push(line);
    }
  }
  return yamlOut.join("\n").trim();
}

export class SOPEnhancer {
  private cache = new Map<string, { content: string; ts: number }>();
  private readonly CACHE_TTL = 30 * 60 * 1000; // 30 min

  private readonly patterns: SOPPattern[];

  constructor() {
    const home = homedir();
    this.patterns = [
      // --- Service-specific ---
      {
        pattern: /comfyui|flux|8188|diffusion|image.gen/i,
        sopPaths: [join(home, "Projects/ComfyUI/comfyui.ai.sop")],
        label: "ComfyUI",
        priority: 8,
        sections: ["preflight", "credentials", "troubleshooting"],
      },
      {
        pattern: /ft.?991|hamlib|rigctl|radio|ham/i,
        sopPaths: [join(home, "Projects/lbf-ham-radio/ft991a.ai.sop")],
        label: "FT-991A",
        priority: 8,
        sections: ["preflight", "gotchas", "credentials"],
      },
      {
        pattern: /augur|trading|paper_augur|coinbase|crypto.*bot/i,
        sopPaths: [join(home, "Projects/augur-trading/augur.ai.sop")],
        label: "Augur",
        priority: 8,
        sections: ["preflight", "gotchas", "credentials"],
      },
      {
        pattern: /octoprint|3d.?print|prusa|\.141/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/3d-printing.ai.sop")],
        label: "3D Printing",
        priority: 7,
        sections: ["preflight", "gotchas"],
      },
      {
        pattern: /docker|container|compose/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/docker-deploy.ai.sop")],
        label: "Docker Deploy",
        priority: 7,
        sections: ["preflight", "gotchas", "rollback"],
      },
      {
        pattern: /wazuh|security.*audit|hardening|firewall/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/security-audit.ai.sop")],
        label: "Security",
        priority: 9,
        sections: ["preflight", "credentials", "gotchas"],
      },
      // --- Fleet ---
      {
        pattern: /ssh\s|\.163|\.179|\.141|\.100|blackview|radio\.fleet|octopi/i,
        sopPaths: [join(home, "Projects/lbf-infrastructure/fleet.ai.sop")],
        label: "Fleet Access",
        priority: 9,
        sections: ["preflight", "security", "credentials"],
      },
      // --- Git operations ---
      {
        pattern: /git\s+(push|pull|merge|rebase|reset|cherry-pick)/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/merge.ai.sop")],
        label: "Git Operations",
        priority: 6,
        sections: ["preflight", "merge", "rollback"],
      },
      // --- Database ---
      {
        pattern: /sqlite|postgres|mysql|database|migration/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/database.ai.sop")],
        label: "Database Operations",
        priority: 8,
        sections: ["backup", "migration", "recovery"],
      },
      // --- Python env ---
      {
        pattern: /pip\s+install|conda|venv|virtualenv|poetry/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/python-env.ai.sop")],
        label: "Python Environment",
        priority: 5,
        sections: ["setup", "dependencies", "troubleshooting"],
      },
      // --- WEMS ---
      {
        pattern: /wems|earthquake|seismic/i,
        sopPaths: [join(home, "Projects/wems-mcp-server/wems.ai.sop")],
        label: "WEMS",
        priority: 6,
        sections: ["preflight", "gotchas", "credentials"],
      },
      // --- Cortex itself ---
      {
        pattern: /cortex|brain\.db|embeddings|memory.*system/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/cortex.ai.sop")],
        label: "Cortex",
        priority: 7,
        sections: ["preflight", "gotchas"],
      },
      // --- Deployment / release ---
      {
        pattern: /npm\s+publish|pypi|release|deploy|semver/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/release.ai.sop")],
        label: "Release / Deploy",
        priority: 8,
        sections: ["preflight", "checklist", "rollback"],
      },
      // --- Network diagnostics ---
      {
        pattern: /ping|traceroute|netstat|nslookup|dig\s/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/network.ai.sop")],
        label: "Network Diagnostics",
        priority: 3,
        sections: ["diagnostics", "common_issues"],
      },
      // --- File operations ---
      {
        pattern: /rsync|scp\s|tar\s|backup/i,
        sopPaths: [join(home, "Projects/helios/extensions/cortex/sop/file-ops.ai.sop")],
        label: "File Operations",
        priority: 5,
        sections: ["permissions", "backup", "recovery"],
      },
    ];
  }

  /**
   * Find all SOPs matching the given context string (JSON-serialized params).
   * Returns matches sorted by priority descending.
   */
  async findMatches(contextString: string): Promise<SOPMatch[]> {
    const results: SOPMatch[] = [];

    for (const pat of this.patterns) {
      if (!pat.pattern.test(contextString)) continue;

      for (const sopPath of pat.sopPaths) {
        const content = await this.loadSOP(sopPath);
        if (!content) continue;

        // Extract requested sections
        const sectionContent = pat.sections
          .map((s) => {
            const body = extractSection(content, s);
            return body ? `### ${s}\n${body}` : "";
          })
          .filter(Boolean)
          .join("\n\n");

        results.push({
          label: pat.label,
          path: sopPath,
          content: sectionContent || content.slice(0, 1500),
          priority: pat.priority,
          matchedPattern: pat.pattern.source,
          sections: pat.sections,
        });
      }
    }

    return results.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Load SOP content with caching
   */
  private async loadSOP(path: string): Promise<string | null> {
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      return cached.content;
    }

    try {
      if (!existsSync(path)) return null;
      const content = await readFile(path, "utf-8");
      this.cache.set(path, { content, ts: Date.now() });
      return content;
    } catch {
      return null;
    }
  }
}
