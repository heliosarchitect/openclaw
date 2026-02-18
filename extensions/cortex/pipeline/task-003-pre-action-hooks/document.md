# Pre-Action Hook System - Documentation

**Task ID:** task-003-pre-action-hooks  
**Version:** 2.0.0  
**Date:** 2026-02-18  
**Author:** Documentation Specialist (Sub-Agent)  
**Pipeline Stage:** Document

## Table of Contents

1. [Overview](#overview)
2. [API Documentation](#api-documentation)
3. [Configuration Guide](#configuration-guide)
4. [Integration Guide](#integration-guide)
5. [Performance Tuning Guide](#performance-tuning-guide)
6. [Troubleshooting Guide](#troubleshooting-guide)
7. [Examples](#examples)
8. [Migration Guide](#migration-guide)

---

## Overview

The Pre-Action Hook System transforms Helios from voluntary knowledge consultation to **mandatory** pre-execution checks. This system intercepts ALL tool calls in the OpenClaw extension framework, performs automated knowledge discovery, and forces agents to acknowledge relevant SOPs, confidence-rated memories, and contextual warnings before execution proceeds.

### Key Features

- **Universal Tool Interception**: Monitors all tool calls (`exec`, `nodes`, `browser`, `message`)
- **Intelligent Context Extraction**: Automatically detects projects, services, hosts, and operations
- **Multi-Source Knowledge Discovery**: Queries SOPs and Cortex memories in parallel
- **Configurable Enforcement Levels**: From advisory warnings to strict blocking
- **Performance Optimized**: <150ms additional latency with aggressive caching
- **Fail-Safe Design**: Never blocks tool execution due to system errors

### Architecture Overview

```
Tool Call → Context Extraction → Knowledge Discovery → Enforcement Decision → Execution
    ↑              ↑                    ↑                    ↑               ↑
(Any Tool)   (Smart Keywords)    (SOP + Cortex)      (Block/Advise)    (With Knowledge)
```

---

## API Documentation

### Core Interfaces

#### KnowledgeContext

Represents the extracted context from a tool call for knowledge discovery.

```typescript
interface KnowledgeContext {
  toolName: string; // Tool being called (exec, nodes, browser, etc.)
  params: Record<string, unknown>; // Original tool parameters
  keywords: string[]; // Extracted context keywords
  projectPath?: string; // Detected project path (/Projects/{name})
  serviceType?: string; // Detected service (comfyui, docker, augur, etc.)
  hostTarget?: string; // Target host (IP, hostname)
  workingDir?: string; // Working directory from exec calls
  urlHost?: string; // Hostname from browser calls
  riskLevel: "low" | "medium" | "high" | "critical"; // Operation risk assessment
}
```

#### KnowledgeResult

Contains discovered knowledge from all sources.

```typescript
interface KnowledgeResult {
  sopFiles: Array<{
    label: string; // Human-readable SOP identifier
    path: string; // File system path to SOP
    content: string; // Relevant sections (preflight, gotchas, credentials)
    priority: number; // Match priority (higher = more relevant)
    matchedPattern: string; // Pattern that triggered this SOP
  }>;

  memories: Array<{
    id: string; // Memory identifier
    content: string; // Memory content
    confidence: number; // Confidence score (0.0-1.0)
    category: string; // Memory category (process, technical, etc.)
    lastAccessed: string; // ISO timestamp of last access
    accessCount: number; // Number of times accessed
  }>;

  totalSources: number; // Total knowledge sources found
  lookupTimeMs: number; // Time spent discovering knowledge
  cacheHits: number; // Number of cache hits (for performance monitoring)
}
```

#### EnforcementConfig

Configuration for enforcement behavior.

```typescript
interface EnforcementConfig {
  level: EnforcementLevel; // Global enforcement level
  categoryRules: Map<string, EnforcementLevel>; // Per-category overrides
  cooldownMs: number; // Time before re-showing same knowledge
  confidenceThresholds: Map<string, number>; // Minimum confidence per operation type
  emergencyBypass: boolean; // Allow bypassing enforcement
  interceptTools: string[]; // Tools to intercept
}

enum EnforcementLevel {
  DISABLED = "disabled", // No interception
  ADVISORY = "advisory", // Show knowledge but don't block
  CATEGORY = "category", // Enforce per-category rules
  STRICT = "strict", // Block all tool calls with relevant knowledge
}
```

### Core Classes

#### KnowledgeDiscovery

Main engine for discovering relevant knowledge before tool execution.

```typescript
class KnowledgeDiscovery {
  /**
   * Extract context keywords and metadata from tool call parameters
   */
  async extractContext(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<KnowledgeContext>;

  /**
   * Find relevant SOP files based on extracted context
   */
  async discoverSOPs(context: KnowledgeContext): Promise<SopResult[]>;

  /**
   * Find relevant memories from Cortex with confidence filtering
   */
  async discoverMemories(
    context: KnowledgeContext,
    confidenceThreshold: number,
  ): Promise<MemoryResult[]>;

  /**
   * Perform parallel lookup across all knowledge sources
   * Times out after maxLookupMs to prevent blocking tool execution
   */
  async parallelLookup(
    context: KnowledgeContext,
    options: {
      confidenceThreshold: number;
      maxLookupMs: number;
      includeCategories: string[];
    },
  ): Promise<KnowledgeResult>;
}
```

#### EnforcementEngine

Handles enforcement decisions and knowledge injection formatting.

```typescript
class EnforcementEngine {
  /**
   * Determine if tool execution should be blocked based on discovered knowledge
   */
  async shouldBlock(
    context: KnowledgeContext,
    knowledge: KnowledgeResult,
    config: EnforcementConfig,
  ): Promise<{ block: boolean; reason?: string }>;

  /**
   * Format discovered knowledge into user-friendly injection message
   */
  async formatKnowledgeInjection(knowledge: KnowledgeResult): Promise<string>;

  /**
   * Track knowledge injection to implement cooldown mechanism
   */
  async trackInjection(key: string): void;

  /**
   * Check if knowledge was recently shown (cooldown active)
   */
  async checkCooldown(key: string, cooldownMs: number): Promise<boolean>;
}
```

#### ContextExtractor

Intelligent extraction of context from tool call parameters.

```typescript
class ContextExtractor {
  /**
   * Extract keywords from tool parameters using pattern matching
   */
  async extractKeywords(toolName: string, params: Record<string, unknown>): Promise<string[]>;

  /**
   * Detect project context from file paths
   */
  async detectProject(params: Record<string, unknown>): Promise<string | null>;

  /**
   * Detect service type from commands and parameters
   */
  async detectService(params: Record<string, unknown>): Promise<string | null>;

  /**
   * Detect target host from parameters
   */
  async detectHost(params: Record<string, unknown>): Promise<string | null>;
}
```

### Hook Registration API

```typescript
// Register pre-action hook with OpenClaw plugin system
api.on(
  "before_tool_call",
  async (event, _ctx) => {
    const { toolName, params } = event;

    // Check if this tool should be intercepted
    if (!config.interceptTools.includes(toolName)) {
      return; // Let tool execute normally
    }

    try {
      // Extract context from tool call
      const context = await knowledgeDiscovery.extractContext(toolName, params);

      // Discover relevant knowledge
      const knowledge = await knowledgeDiscovery.parallelLookup(context, {
        confidenceThreshold: getConfidenceThreshold(context.riskLevel),
        maxLookupMs: config.maxLookupMs || 150,
        includeCategories: ["process", "technical", "security", "gotchas", "credentials"],
      });

      // Make enforcement decision
      const enforcement = await enforcementEngine.shouldBlock(context, knowledge, config);

      // Log metrics
      await writeMetric("pre_action_hook", {
        tool_name: toolName,
        knowledge_sources: knowledge.totalSources,
        lookup_time_ms: knowledge.lookupTimeMs,
        blocked: enforcement.block,
        cache_hits: knowledge.cacheHits,
      });

      if (enforcement.block) {
        return {
          block: true,
          blockReason: enforcement.reason,
        };
      }
    } catch (err) {
      // Fail-open: never block due to hook errors
      api.logger.debug?.(`Pre-action hook error: ${err}`);
      return; // Allow tool to execute
    }
  },
  { priority: 95 },
);
```

---

## Configuration Guide

### Basic Configuration

The Pre-Action Hook System is configured via the Cortex plugin configuration file:

```json
{
  "preActionHooks": {
    "enabled": true,
    "enforcement": "category",
    "interceptTools": ["exec", "nodes", "browser", "message"],
    "cooldownMinutes": 5,
    "emergencyBypass": false
  }
}
```

### Enforcement Levels

#### DISABLED

No tool interception. System is completely inactive.

```json
{
  "preActionHooks": {
    "enforcement": "disabled"
  }
}
```

#### ADVISORY

Shows relevant knowledge but never blocks tool execution.

```json
{
  "preActionHooks": {
    "enforcement": "advisory"
  }
}
```

#### CATEGORY (Recommended)

Enforces different levels per knowledge category.

```json
{
  "preActionHooks": {
    "enforcement": "category",
    "categoryRules": {
      "process": "strict", // Block for process-related knowledge
      "security": "strict", // Block for security knowledge
      "credentials": "strict", // Block for credential knowledge
      "technical": "advisory", // Advise for technical knowledge
      "gotchas": "advisory", // Advise for gotcha knowledge
      "general": "disabled" // Ignore general knowledge
    }
  }
}
```

#### STRICT

Blocks ALL tool calls when relevant knowledge is found.

```json
{
  "preActionHooks": {
    "enforcement": "strict",
    "cooldownMinutes": 10 // Longer cooldown for strict mode
  }
}
```

### Confidence Thresholds

Configure minimum confidence scores for different operation risk levels:

```json
{
  "preActionHooks": {
    "confidenceThresholds": {
      "critical": 0.8, // High-risk operations need high-confidence knowledge
      "high": 0.7,
      "medium": 0.5, // Medium-risk operations use medium-confidence knowledge
      "low": 0.3 // Low-risk operations include low-confidence knowledge
    }
  }
}
```

### Performance Tuning Configuration

```json
{
  "preActionHooks": {
    "performance": {
      "maxLookupMs": 150, // Hard timeout for knowledge discovery
      "cacheTtlMinutes": 30, // How long to cache SOP content and memory results
      "parallelQueries": true, // Enable parallel SOP and memory lookups
      "enableMetrics": true // Track performance metrics
    }
  }
}
```

### Tool-Specific Configuration

Configure which tools to intercept and how:

```json
{
  "preActionHooks": {
    "toolConfig": {
      "exec": {
        "intercept": true,
        "riskAssessment": true, // Assess risk based on command
        "hostDetection": true // Extract target hosts from ssh commands
      },
      "nodes": {
        "intercept": true,
        "enforcement": "strict" // Always strict for node operations
      },
      "browser": {
        "intercept": true,
        "urlExtraction": true // Extract hostnames from URLs
      },
      "message": {
        "intercept": false // Don't intercept message tool by default
      }
    }
  }
}
```

### Emergency Bypass

For emergency situations where enforcement must be temporarily disabled:

```json
{
  "preActionHooks": {
    "emergencyBypass": true,
    "bypassReason": "Production incident - immediate access required",
    "bypassUntil": "2026-02-18T18:00:00Z"
  }
}
```

---

## Integration Guide

### Integrating with Existing Cortex Installation

#### Prerequisites

- Cortex v1.3.0 or higher (for confidence scoring)
- OpenClaw Plugin API v2.x+
- Node.js with async/await support

#### Step 1: Update Cortex Extension

The Pre-Action Hook System integrates directly into the existing Cortex extension:

```typescript
// ~/Projects/helios/extensions/cortex/index.ts

import { KnowledgeDiscovery } from "./hooks/knowledge-discovery.js";
import { EnforcementEngine } from "./hooks/enforcement-engine.js";
import { ContextExtractor } from "./hooks/context-extractor.js";

// Initialize hook system components
const contextExtractor = new ContextExtractor();
const knowledgeDiscovery = new KnowledgeDiscovery(cortexBridge, contextExtractor);
const enforcementEngine = new EnforcementEngine(config.preActionHooks);

// Replace existing SOP hook (lines 672-880) with enhanced version
api.on("before_tool_call", async (event, _ctx) => {
  // Enhanced hook implementation (see API Documentation)
});
```

#### Step 2: Configure Knowledge Sources

Ensure your knowledge sources are properly configured:

**SOP Files**: Place `.ai.sop` files in project directories

```bash
~/Projects/myproject/myproject.ai.sop
~/Projects/helios/extensions/cortex/sop/comfyui.ai.sop
~/Projects/helios/extensions/cortex/sop/fleet.ai.sop
```

**Cortex Memories**: Ensure critical memories are properly categorized

```typescript
// Add process-related memories with high importance
cortex_add({
  content: "Before deploying to production, always run tests and backup database",
  categories: ["process", "deployment"],
  importance: 3.0, // Critical
});
```

#### Step 3: Test Integration

Verify the integration works correctly:

```bash
# Test SOP detection
~/Projects/myproject $ echo "ls -la" | cortex exec

# Should trigger myproject.ai.sop if it exists
# Should inject relevant process memories
# Should respect configured enforcement level
```

### Integrating with Custom Tools

To add Pre-Action Hook support to custom tools:

#### Step 1: Register Your Tool

Add your tool to the intercept list:

```json
{
  "preActionHooks": {
    "interceptTools": ["exec", "nodes", "browser", "message", "my_custom_tool"]
  }
}
```

#### Step 2: Implement Context Extraction

Add pattern matching for your tool's parameters:

```typescript
// ~/Projects/helios/extensions/cortex/hooks/context-extractor.ts

// Add patterns for your custom tool
private initializePatterns(): void {
  this.patterns.set('my_custom_tool', [
    {
      pattern: /database:\s*(\w+)/i,
      extractor: (match) => [`database_${match[1]}`, 'database_operation'],
      priority: 10
    },
    {
      pattern: /environment:\s*(\w+)/i,
      extractor: (match) => [`env_${match[1]}`, 'environment'],
      priority: 8
    }
  ]);
}
```

#### Step 3: Create Relevant SOPs

Create SOPs that will be triggered by your tool:

```yaml
# ~/Projects/myproject/database.ai.sop
name: "Database Operations"
description: "Critical procedures for database operations"

preflight:
  - "Verify database backup is less than 24 hours old"
  - "Confirm maintenance window if production database"
  - "Check disk space on database server"

gotchas:
  - "Production database requires explicit confirmation"
  - "Rollback procedures must be documented before changes"

credentials:
  - "Database admin password in 1Password vault 'Infrastructure'"
  - "Backup verification requires read access to backup storage"
```

### Integrating with CI/CD Pipelines

For automated environments, configure appropriate enforcement levels:

```json
{
  "preActionHooks": {
    "enforcement": "advisory", // Don't block automated processes
    "ciMode": {
      "enabled": true,
      "logOnly": true, // Log knowledge but never block
      "includeInReports": true // Include in build reports
    }
  }
}
```

---

## Performance Tuning Guide

### Understanding Performance Characteristics

The Pre-Action Hook System adds latency to every intercepted tool call. Here's how to optimize:

#### Latency Sources

1. **Context Extraction**: ~5-15ms (pattern matching)
2. **SOP File Reading**: ~10-50ms (cached after first read)
3. **Memory Search**: ~20-100ms (depends on database size)
4. **Knowledge Formatting**: ~5-10ms (template rendering)

**Total Target**: <150ms (95th percentile)

#### Performance Monitoring

Enable detailed performance metrics:

```json
{
  "preActionHooks": {
    "performance": {
      "enableMetrics": true,
      "detailedTiming": true,
      "slowQueryThreshold": 100
    }
  }
}
```

Monitor metrics via Cortex metrics API:

```typescript
// View performance metrics
const metrics = await api.getMetrics("pre_action_hook");
console.log(`Average lookup time: ${metrics.avg_lookup_time_ms}ms`);
console.log(`Cache hit rate: ${metrics.cache_hit_rate * 100}%`);
console.log(`Slow queries: ${metrics.slow_queries}`);
```

### Optimization Strategies

#### 1. Aggressive Caching

Cache frequently accessed content:

```json
{
  "preActionHooks": {
    "performance": {
      "cache": {
        "sopTtlMinutes": 60, // Cache SOP content for 1 hour
        "memoryTtlMinutes": 30, // Cache memory results for 30 minutes
        "contextTtlMinutes": 10, // Cache extracted context for 10 minutes
        "maxCacheSize": "50MB" // Maximum cache size
      }
    }
  }
}
```

#### 2. Selective Interception

Only intercept high-value tools:

```json
{
  "preActionHooks": {
    "interceptTools": ["exec", "nodes"], // Skip browser, message for performance
    "highRiskOnly": true, // Only intercept high-risk operations
    "skipPatterns": ["^ls", "^pwd", "^cd"] // Skip common safe commands
  }
}
```

#### 3. Parallel Optimization

Optimize parallel query execution:

```json
{
  "preActionHooks": {
    "performance": {
      "parallelQueries": true,
      "maxConcurrentQueries": 5,
      "queryTimeout": 100, // Shorter timeout for performance
      "backgroundRefresh": true // Refresh cache in background
    }
  }
}
```

#### 4. Database Optimization

Optimize Cortex memory database:

```sql
-- Add indexes for category-based queries
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
CREATE INDEX IF NOT EXISTS idx_memories_category_confidence ON memories(category, confidence);

-- Vacuum regularly
PRAGMA auto_vacuum = INCREMENTAL;
```

#### 5. Memory Query Optimization

Optimize memory queries for specific categories:

```typescript
// Use category-focused search instead of general search
const memories = await cortexBridge.searchByCategory(
  ["process", "security", "gotchas"], // Specific high-value categories
  context.keywords,
  {
    limit: 10, // Limit results for performance
    minConfidence: 0.6, // Higher threshold for faster queries
    cacheResults: true, // Cache category searches
  },
);
```

### Performance Benchmarks

Target performance metrics for a well-tuned system:

| Metric             | Target | Good   | Poor   |
| ------------------ | ------ | ------ | ------ |
| Average Latency    | <50ms  | <100ms | >150ms |
| 95th Percentile    | <150ms | <200ms | >300ms |
| Cache Hit Rate     | >80%   | >60%   | <40%   |
| Memory Usage       | <50MB  | <100MB | >200MB |
| Query Timeout Rate | <1%    | <5%    | >10%   |

### Troubleshooting Performance Issues

#### High Latency

```bash
# Check performance metrics
curl http://localhost:3000/metrics | grep pre_action_hook

# Look for slow queries
grep "slow_query" ~/.openclaw/logs/cortex.log | tail -20

# Check cache hit rate
grep "cache_miss" ~/.openclaw/logs/cortex.log | wc -l
```

#### Memory Usage Issues

```bash
# Monitor memory usage
ps aux | grep node | grep openclaw
top -p $(pgrep -f openclaw)

# Check cache size
du -sh ~/.openclaw/cache/cortex/
```

#### Database Performance

```bash
# Analyze Cortex database
sqlite3 ~/.openclaw/extensions/cortex/brain.db ".schema"
sqlite3 ~/.openclaw/extensions/cortex/brain.db "EXPLAIN QUERY PLAN SELECT * FROM memories WHERE category='process'"
```

---

## Troubleshooting Guide

### Common Issues

#### 1. Tool Calls Not Being Intercepted

**Symptoms**: No knowledge injection despite relevant SOPs/memories existing

**Debugging**:

```bash
# Check if hooks are registered
grep "before_tool_call" ~/.openclaw/logs/cortex.log

# Verify tool is in intercept list
cat ~/.openclaw/extensions/cortex/config.json | jq '.preActionHooks.interceptTools'

# Check enforcement level
cat ~/.openclaw/extensions/cortex/config.json | jq '.preActionHooks.enforcement'
```

**Solutions**:

- Verify tool name matches exactly (case-sensitive)
- Check that enforcement level is not "disabled"
- Ensure hooks are properly registered during startup

#### 2. No Relevant Knowledge Found

**Symptoms**: Hook runs but no SOPs or memories are discovered

**Debugging**:

```bash
# Test context extraction
node -e "
const extractor = require('./hooks/context-extractor.js');
console.log(extractor.extractKeywords('exec', { command: 'ssh user@192.168.1.179' }));
"

# Check SOP patterns
ls -la ~/Projects/*/sop/*.ai.sop
grep -r "179" ~/Projects/*/sop/*.ai.sop

# Test memory search
sqlite3 ~/.openclaw/extensions/cortex/brain.db "
SELECT content, category, confidence
FROM memories
WHERE category IN ('process', 'technical', 'security')
AND confidence > 0.5;
"
```

**Solutions**:

- Verify SOP files exist and match naming patterns
- Check that memories are properly categorized
- Adjust confidence thresholds if too restrictive

#### 3. Performance Issues

**Symptoms**: Tool calls taking >500ms, timeouts

**Debugging**:

```bash
# Check performance logs
grep "lookup_time_ms" ~/.openclaw/logs/cortex.log | tail -10

# Monitor database performance
sqlite3 ~/.openclaw/extensions/cortex/brain.db ".timer on" ".explain on" "SELECT * FROM memories WHERE category='process' LIMIT 10;"

# Check cache status
curl http://localhost:3000/cortex/cache/stats
```

**Solutions**:

- Reduce maxLookupMs timeout
- Enable aggressive caching
- Optimize database indexes
- Reduce number of intercepted tools

#### 4. Knowledge Injection Formatting Issues

**Symptoms**: Malformed or confusing knowledge injection messages

**Debugging**:

```bash
# Test knowledge formatting
node -e "
const engine = require('./hooks/enforcement-engine.js');
const mockKnowledge = { sopFiles: [...], memories: [...] };
console.log(engine.formatKnowledgeInjection(mockKnowledge));
"
```

**Solutions**:

- Update knowledge injection templates
- Ensure SOP files have proper section headers
- Check memory content for formatting issues

#### 5. Cooldown Not Working

**Symptoms**: Same knowledge shown repeatedly despite cooldown

**Debugging**:

```bash
# Check cooldown tracking
node -e "
const engine = require('./hooks/enforcement-engine.js');
console.log(engine.recentInjections);
"

# Verify cooldown configuration
cat ~/.openclaw/extensions/cortex/config.json | jq '.preActionHooks.cooldownMinutes'
```

**Solutions**:

- Verify cooldown keys are unique and consistent
- Check system clock for time issues
- Clear cooldown cache if corrupted

### Emergency Procedures

#### Disable System Immediately

```bash
# Method 1: Configuration
echo '{"preActionHooks": {"enforcement": "disabled"}}' > ~/.openclaw/extensions/cortex/emergency-config.json

# Method 2: Environment variable
export CORTEX_DISABLE_HOOKS=true

# Method 3: Kill switch in code
touch ~/.openclaw/extensions/cortex/DISABLE_HOOKS
```

#### Emergency Bypass

```bash
# Temporary bypass for specific operations
export CORTEX_EMERGENCY_BYPASS=true
export CORTEX_BYPASS_REASON="Production incident #12345"

# Your critical commands here
ssh admin@production-server "systemctl restart service"

# Disable bypass
unset CORTEX_EMERGENCY_BYPASS
unset CORTEX_BYPASS_REASON
```

#### System Recovery

```bash
# Restart OpenClaw with clean state
systemctl restart openclaw

# Clear all caches
rm -rf ~/.openclaw/cache/cortex/

# Reset hook system
sqlite3 ~/.openclaw/extensions/cortex/brain.db "DELETE FROM metrics WHERE type='pre_action_hook';"

# Verify system health
curl http://localhost:3000/health | jq '.extensions.cortex'
```

### Diagnostic Commands

```bash
# Complete system diagnostic
cat << 'EOF' > cortex-diagnostic.sh
#!/bin/bash
echo "=== Cortex Pre-Action Hook Diagnostic ==="
echo "Date: $(date)"
echo "Version: $(cat ~/.openclaw/extensions/cortex/package.json | jq -r '.version')"
echo

echo "=== Configuration ==="
cat ~/.openclaw/extensions/cortex/config.json | jq '.preActionHooks'
echo

echo "=== Hook Registration ==="
grep -c "before_tool_call" ~/.openclaw/logs/cortex.log
echo

echo "=== Recent Activity ==="
grep "pre_action_hook" ~/.openclaw/logs/cortex.log | tail -5
echo

echo "=== Performance Metrics ==="
curl -s http://localhost:3000/metrics | grep pre_action_hook
echo

echo "=== Knowledge Sources ==="
echo "SOPs: $(find ~/Projects -name "*.ai.sop" | wc -l)"
echo "Memories: $(sqlite3 ~/.openclaw/extensions/cortex/brain.db "SELECT COUNT(*) FROM memories WHERE category IN ('process','technical','security','gotchas');")"
echo

echo "=== Cache Status ==="
du -sh ~/.openclaw/cache/cortex/
echo
EOF

chmod +x cortex-diagnostic.sh
./cortex-diagnostic.sh
```

---

## Examples

### Example 1: Fleet Operation with SOP Enforcement

**Scenario**: Agent tries to SSH to fleet host, triggers fleet SOP

```bash
# Agent command
exec({ command: "ssh admin@192.168.1.179 'systemctl restart comfyui'" })
```

**Context Extraction**:

```json
{
  "toolName": "exec",
  "keywords": ["ssh", "192.168.1.179", "systemctl", "restart", "comfyui"],
  "hostTarget": "192.168.1.179",
  "serviceType": "comfyui",
  "riskLevel": "high"
}
```

**Knowledge Discovered**:

```yaml
# fleet.ai.sop triggered by IP pattern
SOP: Fleet Management
- Verify host is reachable before critical operations
- Use fleet status command to check service health first
- Document service restart reason in maintenance log

# comfyui.ai.sop triggered by service name
SOP: ComfyUI Management
- Check GPU memory usage before restart
- Backup current workflow configurations
- Verify port 8188 accessibility after restart

# Cortex memories (confidence > 0.7)
- "ComfyUI service restart requires CUDA driver reload on .179" (confidence: 0.85)
- "Fleet host .179 has intermittent network issues - verify connectivity" (confidence: 0.78)
```

**Injection Message**:

```
🛑 KNOWLEDGE INJECTION: Critical information found for this operation

📋 RELEVANT SOPs:
Fleet Management:
• Verify host is reachable before critical operations
• Use fleet status command to check service health first
• Document service restart reason in maintenance log

ComfyUI Management:
• Check GPU memory usage before restart
• Backup current workflow configurations
• Verify port 8188 accessibility after restart

🧠 RELEVANT MEMORIES (high confidence):
• ComfyUI service restart requires CUDA driver reload on .179 (confidence: 85%)
• Fleet host .179 has intermittent network issues - verify connectivity (confidence: 78%)

✅ ACKNOWLEDGMENT REQUIRED: Please review the above information and retry your command to proceed.
```

### Example 2: Advisory Mode for Low-Risk Operation

**Scenario**: Advisory enforcement for file listing operation

```bash
# Agent command
exec({ command: "ls -la /Projects/augur/logs/" })
```

**Knowledge Discovered**:

```yaml
# augur.ai.sop triggered by project path
SOP: AUGUR Trading System
- Log files contain sensitive trading data - handle with care
- Use log rotation to prevent disk space issues
```

**Advisory Message** (not blocking):

```
💡 ADVISORY: Relevant information available

📋 AUGUR Trading System SOP:
• Log files contain sensitive trading data - handle with care
• Use log rotation to prevent disk space issues

ℹ️ This is advisory only - your command will proceed automatically.
```

### Example 3: Category-Based Enforcement

**Configuration**:

```json
{
  "preActionHooks": {
    "enforcement": "category",
    "categoryRules": {
      "security": "strict", // Block for security-related knowledge
      "process": "advisory", // Advise for process knowledge
      "technical": "disabled" // Ignore technical knowledge
    }
  }
}
```

**Scenario**: Database operation triggers security knowledge

```bash
# Agent command
exec({ command: "mysql -u admin -p production_db" })
```

**Knowledge Discovered**:

```yaml
# Security memory (strict enforcement)
- "Production database access requires VPN and MFA" (category: security, confidence: 0.92)

# Process memory (advisory enforcement)
- "Database operations should be logged in maintenance tracker" (category: process, confidence: 0.78)

# Technical memory (disabled - ignored)
- "MySQL slow query log located at /var/log/mysql/slow.log" (category: technical, confidence: 0.65)
```

**Result**: Blocks due to security category rule, shows advisory for process category

### Example 4: Custom Tool Integration

**Custom Tool Registration**:

```typescript
// Register custom deployment tool
api.on("before_tool_call", async (event, _ctx) => {
  if (event.toolName !== "deploy_service") return;

  const context = await knowledgeDiscovery.extractContext("deploy_service", event.params);
  // ... standard hook processing
});
```

**Custom Context Extraction**:

```typescript
// Context patterns for deploy_service tool
{
  pattern: /service:\s*(\w+)/i,
  extractor: (match) => [`service_${match[1]}`, 'deployment'],
  priority: 10
},
{
  pattern: /environment:\s*(prod|staging|dev)/i,
  extractor: (match) => [`env_${match[1]}`, 'environment', match[1] === 'prod' ? 'production' : 'non_production'],
  priority: 15
}
```

**Usage**:

```javascript
// Agent uses custom tool
deploy_service({
  service: "payment_processor",
  environment: "prod",
  version: "v2.1.0",
});
```

**Knowledge Triggered**:

```yaml
# deployment.ai.sop
SOP: Production Deployment
- All production deployments require approval ticket
- Verify rollback plan is documented and tested
- Monitor service health for 15 minutes post-deployment

# Memories
- "Payment processor deployments require database migration check" (confidence: 0.89)
```

---

## Migration Guide

### Migrating from Basic SOP Enforcement

If you're currently using the basic SOP enforcement system (lines 672-880 in `index.ts`), here's how to migrate:

#### Step 1: Backup Current Configuration

```bash
# Backup current SOP patterns and config
cp ~/.openclaw/extensions/cortex/index.ts ~/.openclaw/extensions/cortex/index.ts.backup
cp ~/.openclaw/extensions/cortex/config.json ~/.openclaw/extensions/cortex/config.json.backup
```

#### Step 2: Update Configuration Format

**Old Format**:

```json
{
  "sopEnforcement": {
    "enabled": true,
    "tools": ["exec", "nodes"]
  }
}
```

**New Format**:

```json
{
  "preActionHooks": {
    "enabled": true,
    "enforcement": "category",
    "interceptTools": ["exec", "nodes", "browser"],
    "categoryRules": {
      "process": "strict",
      "security": "strict",
      "technical": "advisory"
    }
  }
}
```

#### Step 3: Migrate Existing SOPs

Existing `.ai.sop` files work without changes, but you can enhance them:

**Enhanced SOP Format**:

```yaml
name: "Enhanced SOP"
description: "More detailed SOP with confidence and category hints"
categories: ["process", "security"] # Help with categorization
confidence_boost: 0.1 # Boost relevance for this SOP

preflight:
  - "Enhanced preflight checks"

gotchas:
  - "Enhanced gotcha warnings"

credentials:
  - "Enhanced credential information"
```

#### Step 4: Test Migration

```bash
# Test with gradually increasing enforcement
# Start with advisory
jq '.preActionHooks.enforcement = "advisory"' config.json > tmp.json && mv tmp.json config.json

# Test common operations
exec({ command: "ssh admin@192.168.1.179" })
nodes({ action: "run", command: ["systemctl", "status", "comfyui"] })

# Upgrade to category enforcement
jq '.preActionHooks.enforcement = "category"' config.json > tmp.json && mv tmp.json config.json

# Final test with strict enforcement
jq '.preActionHooks.enforcement = "strict"' config.json > tmp.json && mv tmp.json config.json
```

### Migrating from Manual SOP Consultation

If agents currently consult SOPs manually via `cortex_stm` or file reading:

#### Before (Manual):

```javascript
// Agent manually checks for SOPs
const sopContent = await read({ path: "/Projects/myproject/myproject.ai.sop" });
// Agent manually reviews SOP content
// Agent manually decides whether to proceed
await exec({ command: "risky_operation" });
```

#### After (Automatic):

```javascript
// Hook automatically discovers and injects relevant SOPs
// Agent must acknowledge injected knowledge
await exec({ command: "risky_operation" });
// If SOPs exist, hook will block and show them
// Agent retry after acknowledgment automatically proceeds
```

### Advanced Migration Scenarios

#### Migrating Custom Hook Systems

If you have custom `before_tool_call` hooks:

```typescript
// Ensure your hooks run after pre-action hooks
api.on(
  "before_tool_call",
  async (event, _ctx) => {
    // Your custom logic
  },
  { priority: 90 },
); // Lower priority than 95 (pre-action hooks)
```

#### Migrating from External Knowledge Systems

If you use external documentation or knowledge bases:

```typescript
// Add custom knowledge source to discovery engine
class CustomKnowledgeSource {
  async findRelevant(context: KnowledgeContext): Promise<KnowledgeItem[]> {
    // Query your external system
    const results = await this.externalAPI.search(context.keywords);
    return results.map((item) => ({
      content: item.text,
      confidence: item.score,
      source: "external_kb",
    }));
  }
}

// Register with discovery engine
knowledgeDiscovery.addSource(new CustomKnowledgeSource());
```

---

## Conclusion

The Pre-Action Hook System represents a fundamental shift from voluntary to mandatory knowledge consultation in AI agent operations. By intercepting tool calls and forcing acknowledgment of relevant knowledge, it ensures that critical information is never ignored due to oversight or time pressure.

Key benefits:

- **Prevents repeated mistakes** through mandatory knowledge injection
- **Improves operational safety** by surfacing relevant SOPs and warnings
- **Maintains performance** through aggressive caching and parallel queries
- **Provides flexibility** through configurable enforcement levels
- **Ensures reliability** through fail-safe design that never blocks critical operations

The system is designed to be:

- **Unobtrusive**: <150ms additional latency for most operations
- **Intelligent**: Context-aware knowledge discovery across multiple sources
- **Flexible**: Configurable enforcement from advisory to strict blocking
- **Reliable**: Fail-open design ensures system errors never prevent tool execution
- **Observable**: Comprehensive metrics and logging for monitoring and tuning

For support or questions about the Pre-Action Hook System, refer to the troubleshooting guide or contact the Cortex development team.

---

**Document Version**: 1.0  
**Last Updated**: 2026-02-18  
**Next Review**: 2026-03-18
